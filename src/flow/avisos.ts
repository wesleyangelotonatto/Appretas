// Monta os avisos de audiência e prazo para Wesley revisar. Nada é enviado aqui:
// cada aviso entra na fila de confirmação com TODAS as datas encontradas no card
// e a origem de cada uma, porque elas divergem com frequência (vencimento do card
// x comentário da equipe x item de checklist) e quem decide qual vale é ele.

import { getCardsAudiencias, getCardsPrazos } from '../integrations/trello';
import { carregarPlanilha, acharPorProcesso } from '../lookup/sheets';
import { coletarDatasDoCard, extrairNumeroProcesso, DataEncontrada } from './dadosCard';
import { salvarAvisoPendente, registrarCardVisto, buscarContatoProcesso } from '../memory/db';

const TZ = () => process.env.TZ_APP || 'America/Sao_Paulo';

export function formatarData(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { timeZone: TZ(), day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function formatarHora(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { timeZone: TZ(), hour: '2-digit', minute: '2-digit' });
}

const CONECTIVOS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'x']);

// Nomes vêm da planilha e dos cards em CAIXA ALTA ("EDIVANDRO CARLOS MARQUES").
// Escrever assim na mensagem soa como grito, então normaliza.
export function formatarNomeProprio(texto: string): string {
  return String(texto || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((p, i) => (i > 0 && CONECTIVOS.has(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ');
}

const MARCAS_EMPRESA = /\b(ltda|cia|s\/?a|eireli|me|epp|mei|associa[çc][ãa]o|cooperativa|banco|segurad|sicredi|sicoob)\b|&/i;

// Só o primeiro nome no tratamento: "EDIVANDRO CARLOS MARQUES" -> "Edivandro".
// Duas exceções: iniciais soltas ("J. LACHINSKI") não servem como tratamento, e
// pessoa jurídica não tem primeiro nome — nesses casos usa o nome como está.
export function primeiroNome(nome: string): string {
  const limpo = String(nome || '').trim();
  if (!limpo) return '';
  if (MARCAS_EMPRESA.test(limpo)) return formatarNomeProprio(limpo).slice(0, 40);

  const token = limpo.split(/\s+/).find(t => t.replace(/[^A-Za-zÀ-ÿ]/g, '').length >= 3);
  if (!token) return formatarNomeProprio(limpo).slice(0, 40);
  return formatarNomeProprio(token);
}

// "na 1ª Vara" mas "no Juizado": o artigo segue o gênero do termo
export function artigoJuizo(juizo: string): string {
  return new RegExp(`^(\\d+[ºª]?\\s+)?(${TERMOS_MASCULINOS})`, 'i').test(String(juizo || '').trim()) ? 'no' : 'na';
}

// Partes do processo a partir do título do card ("FULANO X BELTRANO")
export function extrairPartes(titulo: string): string {
  let t = String(titulo || '').replace(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/g, '').replace(/\d{20}/g, '');
  const segmentos = t.split(/\s+[-–—]\s+/).map(s => s.trim()).filter(Boolean);
  const comX = segmentos.find(s => /\s+[xX]\s+/.test(s));
  if (!comX) return '';
  const [a, b] = comX.split(/\s+[xX]\s+/);
  if (!a || !b) return '';
  return `${formatarNomeProprio(a)} x ${formatarNomeProprio(b)}`;
}

// Juízo/vara, quando o card informa
const RE_JUIZO = /\b(\d+[ªa°o]?\s*)?(vara|juizado|comarca|tribunal|turma|c[âa]mara|f[óo]rum)\b/i;
// Os cards escrevem o ordinal de qualquer jeito ("1º Vara", "2a Vara"). O certo
// segue o gênero do termo: 1ª Vara, 1ª Turma, mas 1º Juizado, 1º Tribunal.
const TERMOS_FEMININOS = 'vara|turma|c[âa]mara|comarca|regi[ãa]o|se[çc][ãa]o|promotoria|defensoria|instância|instancia';
const TERMOS_MASCULINOS = 'juizado|tribunal|f[óo]rum|ju[íi]zo|cart[óo]rio|of[íi]cio';

export function normalizarOrdinais(texto: string): string {
  return String(texto || '')
    .replace(new RegExp(`(\\d+)\\s*[ºoª°a]?\\s+(${TERMOS_FEMININOS})`, 'gi'), (_m, n, termo) => `${n}ª ${termo}`)
    .replace(new RegExp(`(\\d+)\\s*[ºoª°a]?\\s+(${TERMOS_MASCULINOS})`, 'gi'), (_m, n, termo) => `${n}º ${termo}`);
}

export function extrairJuizo(texto: string): string {
  const segmentos = String(texto || '').split(/\s+[-–—]\s+|\n/).map(s => s.trim()).filter(Boolean);
  const achado = segmentos.find(s => RE_JUIZO.test(s) && s.length < 80);
  return achado ? normalizarOrdinais(formatarNomeProprio(achado)) : '';
}

export type Momento = 'novo' | 'semana' | 'vespera' | 'dia';

// Abertura fixa definida por Wesley: identifica a Iara e explica POR QUE o
// cliente está recebendo o aviso, em vez de uma mensagem solta sobre uma data.
function aberturaPadrao(nome: string): string {
  const tratamento = primeiroNome(nome) ? `Olá, ${primeiroNome(nome)}.` : 'Olá.';
  return `${tratamento} Tudo bem? Aqui é a *Iara*, *secretária* do Doutor Wesley. ` +
    `Ele sempre pede para atualizar sobre todos os andamentos do processo. Por isso, estou passando pra te avisar `;
}

export function montarMensagem(
  tipo: string,
  nome: string,
  dataIso: string,
  processo: string,
  extras: { partes?: string; juizo?: string; momento?: Momento } = {}
): string {
  const data = formatarData(dataIso);
  const hora = formatarHora(dataIso);
  // Nem todo card tem número de processo (recurso administrativo, multa) — sem
  // partes nem número, a frase sai sem a identificação em vez de exibir um vazio
  const partes = extras.partes ? ` (${extras.partes})` : (processo ? ` (${processo})` : '');
  const juizo = extras.juizo ? `, ${artigoJuizo(extras.juizo)} ${extras.juizo},` : '';
  const abertura = aberturaPadrao(nome);

  if (tipo === 'audiencia') {
    // Meia-noite quase sempre significa que a fonte não informou a hora
    const comHora = hora === '00:00' ? '' : `, às ${hora}`;
    const corpo =
      extras.momento === 'vespera'
        ? `que a audiência do seu processo${partes}${juizo} é amanhã, dia ${data}${comHora}.`
        : extras.momento === 'semana'
        ? `que a audiência do seu processo${partes}${juizo} acontece na próxima semana, no dia ${data}${comHora}.`
        : `que foi marcada uma audiência no seu processo${partes}${juizo} para o dia ${data}${comHora}.`;
    return `${abertura}${corpo} Qualquer dúvida sobre o que vai acontecer nela, pode me chamar aqui que eu explico.`;
  }

  return `${abertura}que hoje vamos cumprir um prazo no seu processo${partes}${juizo}. ` +
    `Não é nada para se preocupar: é só para você saber que estamos cuidando e dando andamento. Fico à disposição.`;
}

// Palpite do nome do cliente a partir do título do card, para os processos que
// ainda não estão na planilha. O título costuma ser
// "<número> - <PARTE> X <PARTE CONTRÁRIA> - <assunto>", e a primeira parte
// costuma ser o cliente. É só sugestão: o nome fica editável na tela.
export function nomeSugeridoDoCard(titulo: string): string {
  let t = String(titulo || '').replace(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/g, '').replace(/\d{20}/g, '');
  t = t.replace(/^[\s\-–—]+/, '');
  // Descarta trechos curtos do começo: costumam ser a classe processual
  // ("ATOrd", "AI"), não o nome do cliente
  const segmentos = t.split(/\s+[-–—]\s+/).map(x => x.trim()).filter(Boolean);
  const util = segmentos.find(x => x.replace(/[^A-Za-zÀ-ÿ]/g, '').length >= 6) || segmentos[0] || t;
  const primeiraParte = util.split(/\s+[xX]\s+/)[0] || util;
  return primeiraParte.replace(/\s+/g, ' ').trim().slice(0, 60);
}

export interface ResultadoVarredura {
  criados: number;
  semCadastro: Array<{ card: string; processo: string }>;
  semData: Array<{ card: string }>;
}

// Dia do calendário em São Paulo, para comparar datas sem erro de fuso
function diaSP(iso: string | number): string {
  return new Date(iso).toLocaleDateString('sv-SE', { timeZone: TZ() });
}

function somarDias(base: Date, dias: number): string {
  return diaSP(base.getTime() + dias * 86400000);
}

export async function gerarAvisosParaConfirmacao(_dias = 15): Promise<ResultadoVarredura> {
  const hoje = new Date();
  const diaHoje = diaSP(hoje.getTime());
  const diaAmanha = somarDias(hoje, 1);
  const diaSemana = somarDias(hoje, 7);
  const planilha = await carregarPlanilha();

  const res: ResultadoVarredura = { criados: 0, semCadastro: [], semData: [] };

  for (const [tipo, buscar] of [['audiencia', getCardsAudiencias], ['prazo', getCardsPrazos]] as const) {
    const cards = await buscar();

    for (const card of cards) {
      const cardId = String(card.id || '');
      // Primeiro avistamento do card na lista — gatilho do aviso de audiência nova.
      // Precisa ser registrado antes de qualquer filtro de data, senão um card
      // sem data ainda seria dado como novo de novo na varredura seguinte.
      const cardNovo = registrarCardVisto(cardId, tipo);

      const datas: DataEncontrada[] = await coletarDatasDoCard(card);
      if (!datas.length) {
        res.semData.push({ card: String(card.name || '').slice(0, 90) });
        continue;
      }

      // PRAZO: só avisa no próprio dia do prazo.
      // AUDIÊNCIA: ao entrar na lista, uma semana antes e na véspera.
      const momentos: Array<{ momento: Momento; dataIso: string }> = [];
      if (tipo === 'prazo') {
        const hojeData = datas.find(d => diaSP(d.dataIso) === diaHoje);
        if (hojeData) momentos.push({ momento: 'dia', dataIso: hojeData.dataIso });
      } else {
        const futuras = datas.filter(d => diaSP(d.dataIso) >= diaHoje);
        if (cardNovo && futuras.length) momentos.push({ momento: 'novo', dataIso: futuras[0].dataIso });
        const daquiUmaSemana = datas.find(d => diaSP(d.dataIso) === diaSemana);
        if (daquiUmaSemana) momentos.push({ momento: 'semana', dataIso: daquiUmaSemana.dataIso });
        const vespera = datas.find(d => diaSP(d.dataIso) === diaAmanha);
        if (vespera) momentos.push({ momento: 'vespera', dataIso: vespera.dataIso });
      }
      if (!momentos.length) continue;

      // Card sem número de processo (recurso administrativo, multa de trânsito)
      // também entra: está numa das listas, então é trabalho a avisar. Só não
      // tem como ser procurado na planilha.
      const processo = extrairNumeroProcesso(`${card.name || ''} ${card.desc || ''}`) || '';

      // Sem cadastro na planilha o aviso ENTRA na fila do mesmo jeito, marcado
      // para Wesley completar o contato — deixar de fora escondia justamente os
      // processos que precisam de cadastro, e ele fica sem saber que existem.
      // Ordem de resolução do contato:
      // 1) planilha de processos cadastrados (fonte oficial)
      // 2) o que Wesley já preencheu antes nesta tela, guardado por processo —
      //    evita redigitar nome e telefone a cada varredura
      // 3) palpite tirado do título do card, só para ele não começar do zero
      const cliente = acharPorProcesso(planilha, processo);
      const salvo = cliente?.phone ? null : buscarContatoProcesso(processo, cardId);
      const nome = cliente?.phone ? cliente.name : (salvo?.nome || nomeSugeridoDoCard(card.name || ''));
      const phone = cliente?.phone || salvo?.phone || '';
      const cadastrado = !!phone;
      if (!cadastrado) res.semCadastro.push({ card: String(card.name || '').slice(0, 90), processo });

      // Partes e juízo saem do card: identificam o caso na mensagem, para o
      // cliente saber de qual processo se trata sem precisar do número
      const partes = extrairPartes(card.name || '');
      const juizo = extrairJuizo(`${card.name || ''} - ${card.desc || ''}`);

      for (const { momento, dataIso } of momentos) {
        const criado = salvarAvisoPendente({
          tipo,
          cardId,
          cardNome: String(card.name || '').slice(0, 200),
          processo,
          phone,
          nome,
          datasJson: JSON.stringify(datas),
          mensagem: montarMensagem(tipo, nome, dataIso, processo, { partes, juizo, momento }),
          cadastrado,
          partes,
          juizo,
          momento,
        });
        if (criado) res.criados++;
      }
    }
  }

  return res;
}
