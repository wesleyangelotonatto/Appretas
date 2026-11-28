// Menu "Textos": todos os textos que a Iara usa, num lugar só (pedido de 28/11).
// Padrão = texto original (plano/código). Editado = o que o Wesley salvou (setting
// 'textos_editados'); vale por cima do padrão. Roteiros dos produtos ficam no CRM
// (o CRM também usa) e as frases do follow-up na configuração do follow-up.
import { getSetting, setSetting } from '../memory/db';
import * as P from '../persona';
import { PRINCIPIO, CONEXAO, QUEMFALA, OBJECOES, COMPORTAMENTO, COMANDO, COMUM } from '../vendas/textosPlano';

let cache: { em: number; v: Record<string, string> } = { em: 0, v: {} };
function editados(): Record<string, string> {
  if (Date.now() - cache.em < 15000) return cache.v;
  let v: Record<string, string> = {};
  try { v = JSON.parse(getSetting('textos_editados') || '{}'); } catch { /* vazio */ }
  cache = { em: Date.now(), v };
  return v;
}

// Texto em uso: o editado, se houver; senão o padrão
export function texto(id: string, padrao: string): string {
  const e = editados()[id];
  return e && e.trim() ? e : padrao;
}

export function todosEditados(): string[] { return Object.values(editados()).map(t => t.trim()); }

export interface ItemTexto { id: string; grupo: string; titulo: string; explica: string; padrao: string; emUso?: boolean }

export const MSG_ASSISTENTE_VIRTUAL_PADRAO = 'Sou a Iara, assistente virtual do escritório do Dr. Wesley. Ele faz questão de que ninguém fique esperando, por isso respondo na hora, a qualquer horário. Tudo o que você me contar vai direto para ele e a equipe analisarem, e quando for preciso, ele mesmo te liga.';

export const CATALOGO: ItemTexto[] = [
  { id: 'vendas.comando', grupo: 'Comandos de vendas', titulo: 'Comando da função Vendas', explica: 'Como a Iara conduz a conversa de venda: escuta, empatia, ganho, confiança, provas, as 3 frases obrigatórias, limites e notas internas.', padrao: COMANDO, emUso: true },
  { id: 'vendas.principio', grupo: 'Comandos de vendas', titulo: 'Princípio norteador', explica: 'A ideia central do atendimento de vendas.', padrao: PRINCIPIO, emUso: true },
  { id: 'vendas.conexao', grupo: 'Comandos de vendas', titulo: 'Perguntas de conexão', explica: 'Perguntas para criar vínculo com o produtor.', padrao: CONEXAO, emUso: true },
  { id: 'vendas.quemfala', grupo: 'Comandos de vendas', titulo: 'Quem fala', explica: 'Como a Iara se apresenta e quando passa ao Dr. Wesley.', padrao: QUEMFALA, emUso: true },
  { id: 'vendas.comportamento', grupo: 'Comandos de vendas', titulo: 'Comportamento humano e travas', explica: 'Variação, ritmo e travas antes de enviar.', padrao: COMPORTAMENTO, emUso: true },
  { id: 'vendas.comum', grupo: 'Comandos de vendas', titulo: 'Regras comuns a todos os produtos', explica: 'Perguntas gerais, documentos sempre, ticket mínimo, urgência e honorários de êxito.', padrao: COMUM, emUso: true },
  { id: 'vendas.objecoes', grupo: 'Quebra de objeções', titulo: 'Objeções e como responder', explica: 'Objeções gerais, rodada de acolhimento e método de quebra.', padrao: OBJECOES, emUso: true },
  { id: 'ausencia.fora_horario', grupo: 'Aviso de férias e ausência', titulo: 'Fora do horário', explica: 'Enviado a quem não é lead e escreve fora do horário de atendimento.', padrao: P.MSG_FORA_HORARIO, emUso: true },
  { id: 'ausencia.ferias', grupo: 'Aviso de férias e ausência', titulo: 'Férias / ausência (texto sugerido)', explica: 'Texto que aparece pronto quando o senhor liga o "Aviso de férias/ausência" no topo do painel. Troque [data] pela data de volta.', padrao: 'Oi! Aqui é a Iara. O Dr. Wesley está de férias até o dia [data]. Ele me pediu pra anotar tudo com cuidado e passar pra ele assim que voltar. Se for urgente, me avisa que eu dou um jeito de ele saber antes.', emUso: true },
  { id: 'relacionamento.boas_vindas', grupo: 'Boas-vindas', titulo: 'Boas-vindas ao cliente fechado', explica: 'Sete dias depois de fechar (5.2). Ainda não é enviada automaticamente: fica pronta para quando o pós-venda for ligado.', padrao: 'Seu [nome], seja bem-vindo! O Dr. Wesley pediu pra eu te passar os dados do seu processo: número [número], [vara], comarca de [comarca]. Pelo link [link] o senhor acompanha quando quiser. Qualquer novidade a gente te avisa aqui. Vamos lutar pra conseguir esse resultado pro senhor e pra nós.' },
  { id: 'relacionamento.avaliacao', grupo: 'Pedido de avaliação', titulo: 'Pedido de avaliação no Google', explica: 'Pós-venda (5.2). Ainda não é enviado automaticamente.', padrao: 'Seu [nome], posso te pedir um favor? Se o senhor gostou do atendimento, deixa uma avaliação pro escritório no Google. Ajuda outros produtores a acharem a gente e saberem que é de confiança. É rapidinho, por este link: https://g.page/r/CTPdCYGrMq8IEBM/review. Muito obrigada!' },
  { id: 'relacionamento.descadastro', grupo: 'Pedido de avaliação', titulo: 'Confirmação de descadastro', explica: 'Quando a pessoa pede para não receber mais mensagens (4.11). Ainda não é enviada automaticamente.', padrao: 'Tudo certo, [nome]. Não vou mais te mandar mensagens. Se um dia precisar do Dr. Wesley, é só chamar aqui que a gente atende.' },
  { id: 'fixa.assistente_virtual', grupo: 'Mensagens fixas', titulo: '"Você é robô?"', explica: 'Resposta quando perguntam se é robô ou pessoa (a Iara nunca nega ser assistente virtual).', padrao: MSG_ASSISTENTE_VIRTUAL_PADRAO, emUso: true },
  { id: 'fixa.pix', grupo: 'Mensagens fixas', titulo: 'Dados do PIX', explica: 'Quando o cliente pede o PIX do escritório.', padrao: P.MSG_PIX, emUso: true },
  { id: 'fixa.email', grupo: 'Mensagens fixas', titulo: 'E-mail do escritório', explica: 'Quando o cliente pede o e-mail.', padrao: P.MSG_EMAIL, emUso: true },
  { id: 'fixa.urgencia', grupo: 'Mensagens fixas', titulo: 'Urgência ou reclamação', explica: 'Resposta enquanto a Iara avisa o Dr. Wesley de uma urgência.', padrao: P.MSG_URGENCIA_AGUARDAR, emUso: true },
  { id: 'fixa.pedir_advogado', grupo: 'Mensagens fixas', titulo: 'Pediu para falar com o advogado', explica: 'Quando o cliente pede para falar com o Dr. Wesley.', padrao: P.MSG_PEDIR_ADVOGADO, emUso: true },
  { id: 'fixa.amigo', grupo: 'Mensagens fixas', titulo: 'Mensagem pessoal', explica: 'Quando a mensagem parece pessoal (amigo, família).', padrao: P.MSG_AMIGO, emUso: true },
];

export function listar() {
  const e = editados();
  return CATALOGO.map(i => ({ ...i, atual: e[i.id] && e[i.id].trim() ? e[i.id] : i.padrao, editado: !!(e[i.id] && e[i.id].trim()) }));
}

export function salvar(id: string, valor: string | null, quem: string) {
  if (!CATALOGO.some(i => i.id === id)) return { erro: 'texto desconhecido' };
  const e = { ...editados() };
  if (valor === null || !String(valor).trim()) delete e[id]; else e[id] = String(valor).slice(0, 30000);
  setSetting('textos_editados', JSON.stringify(e));
  const hist = JSON.parse(getSetting('textos_historico') || '[]').slice(-199);
  hist.push({ id, em: Date.now(), quem, restaurado: valor === null });
  setSetting('textos_historico', JSON.stringify(hist));
  cache.em = 0;
  return { ok: true };
}
