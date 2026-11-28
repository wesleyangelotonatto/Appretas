// Função Vendas (plano 4.4 e 4.14). Três posições: desligada / treino / ligada.
// Em TREINO (padrão) a Iara conduz o funil, mas nada é enviado ao lead: cada
// resposta vira rascunho para o Wesley aprovar, editar ou descartar, com a etapa,
// o POP e a regra usada. Sem efeitos colaterais (não muda etiqueta, não dispara
// follow-up, não anota no Trello): ela só SUGERE etapa e próximo passo.
import { criarMensagem } from '../ia';
import { buildSystemPrompt, aplicarGlossario } from '../persona';
import { getSetting, setSetting, getRecentCorrections, getDb } from '../memory/db';
import { fichaDoCRM, configDoCRM, FichaCRM, registrarNaFicha } from '../integrations/crm';
import { PRINCIPIO, CONEXAO, QUEMFALA, OBJECOES, COMPORTAMENTO, COMANDO, COMUM } from './textosPlano';
import type { Genero } from '../persona';
import { texto as textoEditavel } from '../textos/textos';

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

interface Produto { id: string; nome: string; origem?: string; textoCompleto?: string; ativo?: boolean; perguntas?: string[] }

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
  provasAceitas?: boolean;
  fraseObrigatoria?: number | null;
  revisao?: { ok: boolean; problemas: string[]; reescrito: boolean; faltamFrases: number[]; sensivel?: string | null };
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
    f.perfil ? `Perfil do lead (use para adaptar o jeito de falar):\n${f.perfil.slice(0, 1500)}` : '',
    f.notasIara?.length ? `Suas notas anteriores sobre este lead:\n${f.notasIara.map(n => '- ' + (n.detalhe || '').slice(0, 500)).join('\n')}` : '',
    f.documentos ? `Documentos: ${f.documentos.completos ? 'indispensáveis completos' : 'faltam ' + f.documentos.faltam.join(', ')}${f.documentos.dataPrometida ? ' (prometeu até ' + f.documentos.dataPrometida + ')' : ''}` : '',
    f.envios && Object.keys(f.envios).length ? `Já enviado pelo Dr. Wesley: ${Object.keys(f.envios).join(', ')}` : '',
    f.tarefasAbertas?.length ? `Tarefas abertas do escritório: ${f.tarefasAbertas.join('; ')}` : '',
  ].filter(Boolean).join('\n');
}

export async function redigirVendas(phone: string, mensagemCliente: string, historico: Array<{ role: string; body: string }>, genero: Genero = 'N', toque?: string): Promise<RascunhoVendas | null> {
  const [ficha, cfg] = await Promise.all([fichaDoCRM(phone), configDoCRM()]);
  const produtos = ((cfg as any)?.produtos?.produtos || []) as Produto[];
  const textoConversa = historico.map(m => m.body).join(' ') + ' ' + mensagemCliente;
  const produto = escolherProduto(ficha, produtos, textoConversa);

  // Parte fixa (em cache por 1 h): persona + comando de Vendas + regras + POP do produto
  const system = [
    buildSystemPrompt(genero),
    '\n\n=== FUNÇÃO VENDAS (siga estas orientações nesta conversa) ===\n',
    textoEditavel('vendas.comando', COMANDO), textoEditavel('vendas.principio', PRINCIPIO), textoEditavel('vendas.conexao', CONEXAO), textoEditavel('vendas.quemfala', QUEMFALA),
    textoEditavel('vendas.comportamento', COMPORTAMENTO), textoEditavel('vendas.objecoes', OBJECOES), textoEditavel('vendas.comum', COMUM),
    produto ? `\n\n=== POP DO PRODUTO: ${produto.nome} ===\n${produto.textoCompleto || ''}` :
      '\n\n=== PRODUTO AINDA NÃO IDENTIFICADO ===\nDescubra com uma pergunta simples qual é a situação (Proagro, seguro, dívida do financiamento, leilão da terra) antes de seguir o roteiro.',
  ].join('\n');

  // Roteiro do produto: perguntas numeradas e o que já foi respondido (ficha > entrevista)
  const perguntas = (produto?.perguntas || []).filter(Boolean);
  const ent = ficha?.entrevista || null;
  const respondidas = ent?.respostas || {};
  const roteiro = perguntas.length ? `ROTEIRO DO PRODUTO (perguntas da entrevista):
${perguntas.map((q, i) => { const r = respondidas[String(i + 1)]; return `${i + 1}. ${q}${r ? ` — JÁ RESPONDIDA: ${r.resposta}` : ' — FALTA'}`; }).join('\n')}
Faça só a PRÓXIMA pergunta que falta, uma por vez e com naturalidade (pode pular a que já ficou clara na conversa). Não repita perguntas já respondidas.` : '';
  const objAbertas = (ent?.objecoes || []).filter(o => !o.superada);
  const objTxt = objAbertas.length ? `OBJEÇÕES EM ABERTO deste lead: ${objAbertas.map(o => `${o.codigo ? o.codigo + ' ' : ''}${o.resumo}`).join('; ')}` : '';

  const correcoes = getRecentCorrections(10);
  const hist = historico.length
    ? historico.map(m => `${m.role === 'client' ? 'Cliente' : m.role === 'iara' ? 'Iara' : 'Dr. Wesley'}: ${m.body}`).join('\n')
    : '(primeira mensagem)';

  const pedido = `FICHA DO LEAD NO CRM:
${resumoFicha(ficha)}
${roteiro}
${objTxt}

HISTÓRICO DA CONVERSA:
${hist}

${toque ? `O LEAD NÃO RESPONDEU. Esta é uma mensagem de RETOMADA (follow-up), não uma resposta.
TOQUE DESTA VEZ: ${toque}
Regras do follow-up: traga algo NOVO e útil (nunca "só passando para saber"), não repita frases já enviadas, curta, termine com uma pergunta fácil de responder.
Última fala do lead: "${mensagemCliente}"` : `ÚLTIMA MENSAGEM DO LEAD:
"${mensagemCliente}"`}
${correcoes.length ? `\nCORREÇÕES RECENTES DO DR. WESLEY (prefira o estilo corrigido):\n${correcoes.map((c, i) => `${i + 1}. Original: "${c.original.slice(0, 400)}" → Corrigido: "${c.corrected.slice(0, 400)}"`).join('\n')}\n` : ''}
Redija a PRÓXIMA mensagem da Iara para este lead, seguindo a função Vendas e o POP.
Se a última mensagem for um documento ou foto ("[Documento recebido: …]"), CONFIRME na hora o que chegou (pelo nome do arquivo),
diga com clareza o que ainda falta (veja "Documentos" na ficha; se não houver lista, peça o próximo documento do POP)
e pergunte até quando ele consegue mandar o restante.
Responda SOMENTE com um JSON, sem markdown:
{"mensagem": "texto para o WhatsApp, curto, uma ideia por vez",
 "etapa_sugerida": "código de 2 dígitos da etapa do funil que a conversa deve ter depois desta mensagem, ou null se continua",
 "proximo_passo": "o próximo passo combinado ou a combinar, em poucas palavras",
 "regra": "qual parte do roteiro você usou (ex.: 'POP Proagro negado, pergunta 3', 'objeção OB-A', 'pergunta de conexão')",
 "provas_aceitas": true ou false (true só se o lead ACEITOU agora receber decisões de casos parecidos ou contato de clientes),
 "frase_obrigatoria": 1, 2, 3 ou null (qual das três mensagens obrigatórias esta resposta transmite),
 "respostas": {"<número da pergunta do roteiro>": "resumo curto do que o lead respondeu"} — só as que a conversa (inclusive a última mensagem) respondeu e ainda não estão como JÁ RESPONDIDA; {} se nenhuma,
 "objecao": null ou {"codigo": "ex.: 5.1, 5.16, OB-C", "resumo": "a objeção com as palavras dele", "resposta": "como você respondeu", "superada": true ou false},
 "indicios": {"<tese do produto>": "sim" | "nao" | "nao_sabe"} — só quando o lead deu informação sobre a tese (ex.: no leilão: intimação pessoal, valor da avaliação, bem de família, pequena propriedade); {} se nenhum}`;

  const r = await criarMensagem('resposta', { max_tokens: 1200, system, cacheSystem: true, messages: [{ role: 'user', content: pedido }] });
  const bloco = r.content[0];
  const texto = bloco && bloco.type === 'text' ? bloco.text : '';
  const incompleto = r.stop_reason !== 'end_turn' && r.stop_reason !== 'stop_sequence';
  let j: any = null;
  try { j = JSON.parse((texto.match(/\{[\s\S]*\}/) || [texto])[0]); } catch { /* usa o texto puro */ }
  const mensagem = aplicarGlossario(String(j?.mensagem || texto || '').trim());
  if (!mensagem) return null;
  // Registra o progresso da entrevista na ficha do CRM (não bloqueia a resposta)
  if (j && !toque) {
    const resp: Record<string, { pergunta: string; resposta: string }> = {};
    Object.keys(j.respostas && typeof j.respostas === 'object' ? j.respostas : {}).forEach(k => {
      const n = parseInt(k, 10); const v = String(j.respostas[k] || '').trim();
      if (n >= 1 && n <= perguntas.length && v) resp[String(n)] = { pergunta: perguntas[n - 1], resposta: v };
    });
    const obj = j.objecao && typeof j.objecao === 'object' && j.objecao.resumo ? j.objecao : null;
    const ind = j.indicios && typeof j.indicios === 'object' ? j.indicios : {};
    if (Object.keys(resp).length || obj || Object.keys(ind).length || (produto && !ent?.produto)) {
      registrarNaFicha(phone, { tipo: 'entrevista', entrevista: { produto: produto?.nome, respostas: resp, objecao: obj, indicios: ind } }).catch(() => {});
    }
  }
  const etapa = j?.etapa_sugerida && /^\d{2}$/.test(String(j.etapa_sugerida)) ? String(j.etapa_sugerida) : null;
  return {
    mensagem, etapaSugerida: etapa, proximoPasso: j?.proximo_passo || null, regra: j?.regra || null,
    produto: produto?.nome || null, incompleto: incompleto || !j,
    provasAceitas: j?.provas_aceitas === true, fraseObrigatoria: [1, 2, 3].includes(Number(j?.frase_obrigatoria)) ? Number(j.frase_obrigatoria) : null,
  };
}

// ===== Revisor (4.15, item 4): confere cada rascunho de Vendas antes de chegar ao Wesley =====
// Reescreve no máximo 1 vez; se ainda houver problema, o rascunho vai marcado para aprovação.
const FRASES = [
  'Vamos lutar pra conseguir esse resultado pro senhor e pra nós.',
  'O seu ganho é o nosso ganho.',
  'Vamos fazer o melhor pro senhor nos indicar e ser nosso cliente sempre, pra outros casos também.',
];

function frasesJaDitas(historico: Array<{ role: string; body: string }>): number[] {
  const n = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const ditas: number[] = [];
  const falas = historico.filter(m => m.role !== 'client').map(m => n(m.body)).join(' ');
  if (/lutar.{0,40}resultado/.test(falas)) ditas.push(1);
  if (/seu ganho e o nosso ganho/.test(falas)) ditas.push(2);
  if (/nos indicar/.test(falas)) ditas.push(3);
  return ditas;
}

export async function revisar(rv: RascunhoVendas, historico: Array<{ role: string; body: string }>, etapa: string | null) {
  const pedido = `Você revisa uma mensagem que a assistente Iara quer mandar a um lead de um escritório de advocacia do agro.
Aponte SOMENTE problemas reais destas regras:
1. Promete resultado, ganho certo ou prazo ("vamos ganhar", "com certeza", "em X meses recebe").
2. Dá parecer jurídico definitivo (só o Dr. Wesley analisa).
3. Inventa valores, decisões, casos ou dados que não estão na conversa.
4. Nega ser assistente virtual, ou se passa pelo Dr. Wesley.
5. Usa urgência falsa, medo exagerado ou pressão para fechar.
6. Fala de honorários diferentes de: êxito por faixa (30% até 50 mil; 25% até 100 mil; 20% acima) em Proagro/seguro; R$ 5.000 de entrada + 10% do que reduzir ou 20% do que receber na revisão; R$ 10.000 só com decisão no leilão.
7. Frase de acolhimento genérica ("compreendo sua preocupação", "sinto muito pelo ocorrido") ou mensagem longa demais para WhatsApp (mais de ~5 linhas).
8. Envia ou promete enviar ela mesma decisões ou contatos de clientes (só pode OFERECER; quem envia é o Dr. Wesley).

NUNCA aponte como problema as três mensagens obrigatórias do escritório (são autorizadas pelo Dr. Wesley e
não são promessa de resultado): "${FRASES[0]}" / "${FRASES[1]}" / "${FRASES[2]}" (ou variações próximas),
nem a oferta de provas, de que os honorários são no êxito, ou de que a procuração tem limite.
Dizer que "o caso pode ter fundamento" ou "vale o Dr. Wesley analisar" também NÃO é promessa.

ÚLTIMAS MENSAGENS:
${historico.slice(-8).map(m => `${m.role === 'client' ? 'Lead' : 'Escritório'}: ${m.body}`).join('\n')}

MENSAGEM PROPOSTA:
"${rv.mensagem}"

Responda SOMENTE um JSON: {"ok": true|false, "problemas": ["regra N: explicação curta"], "reescrita": "a mensagem corrigida, mantendo o sentido e o tom, ou null se ok",
 "sensivel": null ou "assunto: trecho do lead" quando o LEAD fala de preço/valor de honorários, contrato, reclamação, ameaça de desistir ou negociação delicada}`;
  let res: any = { ok: true, problemas: [], reescrita: null };
  try {
    const r = await criarMensagem('rapido', { max_tokens: 700, messages: [{ role: 'user', content: pedido }] });
    const b = r.content[0];
    res = JSON.parse(((b && b.type === 'text' ? b.text : '').match(/\{[\s\S]*\}/) || ['{}'])[0]);
  } catch (err) { console.error('[vendas] revisor:', (err as Error).message); return { ...rv, revisao: { ok: false, problemas: ['revisor indisponível — conferir à mão'], reescrito: false, faltamFrases: [], sensivel: null } }; }
  // Frases obrigatórias: no momento da proposta/fechamento (07–10) ou hesitação, as que ainda não foram ditas
  const ditas = frasesJaDitas(historico).concat(rv.fraseObrigatoria ? [rv.fraseObrigatoria] : []);
  const faltam = etapa && ['07', '08', '09', '10'].includes(etapa) ? [1, 2, 3].filter(i => !ditas.includes(i)) : [];
  const problemas: string[] = Array.isArray(res.problemas) ? res.problemas.slice(0, 6) : [];
  // Variação (4.9): nunca repetir mensagem já enviada nesta conversa
  const tri = (t: string) => { const w = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean); const out = new Set<string>(); for (let i = 0; i + 2 < w.length; i++) out.add(w.slice(i, i + 3).join(' ')); return out; };
  const novo = tri(rv.mensagem);
  const repetida = novo.size >= 4 && historico.filter(m => m.role !== 'client').some(m => { const a = tri(m.body); let c = 0; novo.forEach(x => { if (a.has(x)) c++; }); return c / novo.size > 0.6; });
  if (repetida) { problemas.push('regra 9: repete mensagem já enviada nesta conversa'); res.ok = false; }
  const sensivel = res.sensivel ? String(res.sensivel).slice(0, 200) : null;
  if (!res.ok && res.reescrita && String(res.reescrita).trim()) {
    return { ...rv, mensagem: aplicarGlossario(String(res.reescrita).trim()), revisao: { ok: false, problemas, reescrito: true, faltamFrases: faltam, sensivel } };
  }
  return { ...rv, revisao: { ok: !!res.ok && !problemas.length, problemas, reescrito: false, faltamFrases: faltam, sensivel } };
}

export function textoFrase(i: number) { return FRASES[i - 1]; }

// Perfil vivo e "Nota da Iara" (T2): no máximo a cada 6 h por lead, função não essencial
const ultimoPerfil = new Map<string, number>();
export async function atualizarPerfilENota(phone: string, historico: Array<{ role: string; body: string }>, ficha: FichaCRM | null) {
  if (Date.now() - (ultimoPerfil.get(phone) || 0) < 6 * 3600 * 1000) return;
  ultimoPerfil.set(phone, Date.now());
  const { tetoEstourado } = await import('../ia');
  if (await tetoEstourado()) return;
  const pedido = `Conversa de um lead com o escritório (agro, advocacia):
${historico.slice(-30).map(m => `${m.role === 'client' ? 'Lead' : m.role === 'iara' ? 'Iara' : 'Dr. Wesley'}: ${m.body}`).join('\n')}

Perfil atual: ${ficha?.perfil || '(nenhum)'}

Responda SOMENTE um JSON:
{"perfil": "até 8 linhas: como se comunica, quem decide, situação financeira percebida, cidade/cultura, motivo e desejo (com as palavras dele), medos e objeções (respondidas ou não)",
 "nota": "nota interna curta: o que funcionou e o que não funcionou, ganho estimado discutido e reação, próximo passo combinado, e uma 'Lição para a Iara'",
 "qualificacao": {
   "valorEstimado": número em reais do que está em jogo (Proagro/seguro a receber, dívida a revisar, valor da terra) SÓ se o lead disse, senão null,
   "urgencia": "alta" (leilão marcado, prescrição/prazo próximo, honorários potenciais acima de R$ 30 mil) | "media" | "baixa" | null,
   "urgenciaMotivo": "por quê, em poucas palavras",
   "encaixe": "sim" | "nao" | "indefinido" (se o caso cabe nas regras de viabilidade do produto: prazos, valores mínimos),
   "encaixeMotivo": "por quê",
   "dataLeilao": "AAAA-MM-DD" se o lead disse a data do leilão, senão null,
   "produto": um destes ids se estiver claro: proagro_negado, proagro_demorando, seguro_agricola_de_lavoura, seguro_de_maquinas, revisao_de_cedulas_rurais, defesa_de_imovel_rural_em_leilao; senão null }}
Não invente nada que não esteja na conversa. Hoje é ${new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`;
  try {
    const r = await criarMensagem('rapido', { max_tokens: 1400, essencial: false, messages: [{ role: 'user', content: pedido }] });
    const b = r.content[0];
    const j = JSON.parse(((b && b.type === 'text' ? b.text : '').match(/\{[\s\S]*\}/) || ['{}'])[0]);
    if (j.perfil) await registrarNaFicha(phone, { tipo: 'perfil', perfil: j.perfil });
    if (j.nota) await registrarNaFicha(phone, { tipo: 'nota_iara', titulo: 'Nota da Iara', detalhe: j.nota });
    if (j.qualificacao && typeof j.qualificacao === 'object') await registrarNaFicha(phone, { tipo: 'qualificacao', qualificacao: j.qualificacao });
  } catch (err) { console.error('[vendas] perfil/nota:', (err as Error).message); }
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
  const sessoes = db.prepare(`SELECT phone, name FROM sessions WHERE phone NOT IN (SELECT phone FROM vendas_comparacao)
    AND phone IN (SELECT phone FROM messages WHERE created_at > ? AND role = 'client') ORDER BY updated_at DESC LIMIT ?`).all(desde, limite * 15) as any[];
  let gerados = 0, pulados = 0, erros = 0;
  for (const s of sessoes) {
    if (gerados >= limite) break;
    if (await tetoEstourado()) break;
    // Só quem é lead pelo CRM (etapa do funil 01–13 exceto 11, ou anúncio)
    const ficha = await fichaDoCRM(s.phone);
    if (!ficha || !ehDaFuncaoVendas(ficha)) { pulados++; continue; }
    const msgs = db.prepare('SELECT role, body, created_at FROM messages WHERE phone = ? ORDER BY created_at').all(s.phone) as any[];
    // Último ponto em que o lead falou e alguém do escritório respondeu em seguida
    // (ignora eco: resposta igual ao que o lead disse, ou vazia)
    const limpa = (t: string) => String(t || '').replace(/\*_[^*]*:_\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    let idx = -1, resp = -1;
    for (let i = msgs.length - 2; i >= 0 && idx < 0; i--) {
      if (msgs[i].role !== 'client' || limpa(msgs[i].body).length < 2) continue;
      for (let k = i + 1; k < Math.min(msgs.length, i + 4); k++) {
        if (msgs[k].role === 'client') break;
        const r = limpa(msgs[k].body);
        if (r.length >= 2 && r !== limpa(msgs[i].body)) { idx = i; resp = k; break; }
      }
    }
    if (idx < 0) { pulados++; continue; }
    try {
      const hist = msgs.slice(Math.max(0, idx - 20), idx).map(m => ({ role: m.role, body: m.body }));
      const rv0 = await redigirVendas(s.phone, msgs[idx].body, hist);
      if (!rv0) { erros++; continue; }
      const rv = await revisar(rv0, hist.concat([{ role: 'client', body: msgs[idx].body }]), ficha.etapa?.codigo || null);
      if (rv.revisao && rv.revisao.problemas.length) rv.regra = (rv.regra || '') + ' · Revisor' + (rv.revisao.reescrito ? ' (reescreveu)' : '') + ': ' + rv.revisao.problemas.join(' | ');
      db.prepare(`INSERT INTO vendas_comparacao (phone, nome, mensagem_cliente, resposta_real, quem_respondeu, rascunho_iara, produto, regra, etapa_sugerida, momento)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(s.phone, s.name, msgs[idx].body, msgs[resp].body, msgs[resp].role === 'iara' ? 'Iara' : 'Dr. Wesley',
        rv.mensagem, rv.produto, rv.regra, rv.etapaSugerida, msgs[idx].created_at);
      gerados++;
    } catch (err) { erros++; console.error('[vendas] reprocessar', s.phone, (err as Error).message); }
  }
  return { gerados, pulados, erros };
}

export function limparComparacoes() { garantirTabela(); return getDb().prepare('DELETE FROM vendas_comparacao').run().changes; }

export function listarComparacoes(limite = 50) {
  garantirTabela();
  return getDb().prepare('SELECT * FROM vendas_comparacao ORDER BY criado_em DESC LIMIT ?').all(limite);
}

// Briefing de passagem (4.9): quando o Wesley assume a conversa, resumo pronto na ficha
export async function briefingDePassagem(phone: string, historico: Array<{ role: string; body: string }>) {
  if (!historico.length) return;
  const pedido = `O Dr. Wesley vai assumir esta conversa agora. Escreva um briefing curto (até 8 linhas) para ele:
quem é a pessoa e o que ela quer; o que já foi dito e combinado; dúvidas ou medos em aberto; o que ela está esperando como resposta agora;
sugestão de próxima fala. Sem inventar nada.

Conversa (mais recente no fim):
${historico.slice(-40).map(m => `${m.role === 'client' ? 'Cliente' : m.role === 'iara' ? 'Iara' : 'Dr. Wesley'}: ${m.body}`).join('\n')}`;
  try {
    const r = await criarMensagem('rapido', { max_tokens: 600, essencial: false, messages: [{ role: 'user', content: pedido }] });
    const b = r.content[0];
    const texto = b && b.type === 'text' ? b.text.trim() : '';
    if (texto) await registrarNaFicha(phone, { tipo: 'nota_iara', titulo: 'Briefing de passagem (o senhor assumiu a conversa)', detalhe: texto });
  } catch (err) { console.error('[vendas] briefing:', (err as Error).message); }
}
