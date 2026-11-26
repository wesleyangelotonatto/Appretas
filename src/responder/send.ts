import axios from 'axios';
import {
  getSetting, salvarTreinamento, enfileirarEnvio, registrarEnvioFalho,
  enviosParaTentar, atualizarEnvioFila, limparEnviosAntigos,
  registrarConfirmacaoPendente, confirmacoesPendentesPorChave, marcarConfirmacao, expirarConfirmacoes,
} from '../memory/db';
import { adicionarNotaCard } from '../integrations/trello';

// Resultado de um envio: só 'enviado' e 'na_fila' significam que a mensagem vai
// (ou já foi) para o cliente. Pausa, calibragem e duplicada nunca saem.
export type StatusEnvio = 'enviado' | 'na_fila' | 'bloqueado' | 'calibragem' | 'duplicado';
export interface ResultadoEnvio { status: StatusEnvio; corpo: string; }

const API_URL = () => process.env.WASPEED_API_URL || 'https://api-whatsapp.wascript.com.br';
const TOKEN = () => process.env.WASPEED_TOKEN || '';

// Trava de emergência: quando pausado, nenhum envio sai para o WhatsApp.
// Ponto único de bloqueio — cobre webhook, crons e painel, já que todos passam por aqui.
// Controlado em tempo real pelo botão do painel (setting 'sistema_pausado' no banco);
// a variável de ambiente SISTEMA_PAUSADO só serve como valor inicial antes do 1º toggle.
export function sistemaPausado(): boolean {
  const setting = getSetting('sistema_pausado');
  if (setting !== null) return setting === '1';
  return process.env.SISTEMA_PAUSADO === 'true';
}

// Toda mensagem que o sistema envia volta pelo webhook como evento "fromMe".
// Sem esse registro, o eco da própria fala da Iara seria gravado de novo no
// histórico como se fosse uma resposta digitada pelo Wesley. Guarda por 5 min.
const enviadasRecentemente = new Map<string, number>();
const ECO_TTL_MS = 5 * 60 * 1000;

export function chaveEco(phone: string, text: string): string {
  return `${phone.replace(/[^0-9]/g, '').slice(-10)}|${text.trim().slice(0, 120)}`;
}

export function registrarEnvioProprio(phone: string, text: string) {
  const agora = Date.now();
  for (const [k, t] of enviadasRecentemente) {
    if (agora - t > ECO_TTL_MS) enviadasRecentemente.delete(k);
  }
  enviadasRecentemente.set(chaveEco(phone, text), agora);
}

// true se esse texto foi enviado pelo próprio sistema há pouco (é eco, não fala nova)
export function isEcoDeEnvioProprio(phone: string, text: string): boolean {
  const k = chaveEco(phone, text);
  const t = enviadasRecentemente.get(k);
  if (t === undefined) return false;
  if (Date.now() - t > ECO_TTL_MS) {
    enviadasRecentemente.delete(k);
    return false;
  }
  return true;
}

// Assinatura em negrito e itálico no topo de toda fala da Iara (no WhatsApp,
// *_texto_* é negrito + itálico). Fica em linha própria, antes do texto.
export const ASSINATURA_IARA = '*_Iara - Secretária_*';

function assinarComoIara(text: string): string {
  if (text.startsWith(ASSINATURA_IARA)) return text;
  return `${ASSINATURA_IARA}\n${text}`;
}

// assinar=false para mensagens que NÃO são da Iara: envio direto do Wesley pelo
// painel e avisos internos ao agendador. O padrão é assinar, de modo que qualquer
// novo ponto de envio da Iara já saia identificado sem precisar lembrar disso.
// Modo calibragem: o sistema recebe, interpreta e redige normalmente, mas NENHUMA
// mensagem chega ao cliente — tudo que sairia é registrado no banco de treinamento.
// Resumos diários, notas e salvamento de arquivos no Drive seguem funcionando, pois
// não são mensagens ao cliente. Controlado pelo painel (setting 'modo_calibragem');
// a variável MODO_CALIBRAGEM só define o valor inicial antes do 1º toggle.
export function modoCalibragem(): boolean {
  const setting = getSetting('modo_calibragem');
  if (setting !== null) return setting === '1';
  return process.env.MODO_CALIBRAGEM === 'true';
}

// Registra no banco de calibração o que teria sido enviado e devolve true para
// interromper o envio. Ponto único: cobre aviso de ausência, urgência, follow-ups,
// prazos, audiências e qualquer ponto de envio futuro, sem depender de lembrar deles.
function interceptadoParaCalibragem(phone: string, texto: string, rotulo: string): boolean {
  if (!modoCalibragem()) return false;
  try {
    salvarTreinamento({ phone, tipo: 'automatica', contexto: rotulo, textoOriginal: texto, textoFinal: texto });
  } catch (err) {
    console.error('[calibragem] falha ao registrar no banco de treinamento:', err);
  }
  console.log(`[calibragem] ${rotulo} NÃO enviado para ${phone} — registrado para calibração`);
  return true;
}

export async function sendMessage(
  phone: string,
  text: string,
  opts: { assinar?: boolean; rotulo?: string } = {}
): Promise<ResultadoEnvio> {
  const corpo = opts.assinar === false ? text : assinarComoIara(text);
  if (sistemaPausado()) {
    console.log(`[send] BLOQUEADO (sistema pausado) — mensagem NÃO enviada para ${phone}`);
    return { status: 'bloqueado', corpo };
  }
  if (interceptadoParaCalibragem(phone, corpo, 'mensagem')) return { status: 'calibragem', corpo };
  // Segunda barreira contra duplicidade: a Iara nunca repete a mesma mensagem
  // para o mesmo contato em poucos minutos — se isso acontece é defeito, não
  // intenção. Não vale para envios do Wesley, que pode repetir o que quiser.
  if (opts.assinar !== false && isEcoDeEnvioProprio(phone, corpo)) {
    console.log(`[send] DUPLICADA descartada — mesma mensagem já enviada há pouco para ${phone}`);
    return { status: 'duplicado', corpo };
  }
  registrarEnvioProprio(phone, corpo);
  try {
    await postarTexto(phone, corpo);
    return { status: 'enviado', corpo };
  } catch (err: any) {
    const detalhe = descreverErro(err);
    if (erroTransitorio(err)) {
      // Waspeed instável: a mensagem não se perde, entra na fila e é reenviada sozinha
      const id = enfileirarEnvio(phone, corpo, opts.rotulo || 'mensagem', detalhe, ESPERAS_REENVIO_SEG[0]);
      console.warn(`[send] falha temporária para ${phone} (${detalhe}) — na fila de reenvio #${id}`);
      return { status: 'na_fila', corpo };
    }
    // Erro definitivo (número inválido, requisição recusada): não adianta repetir
    registrarEnvioFalho(phone, corpo, opts.rotulo || 'mensagem', detalhe);
    console.error('[send] erro ao enviar mensagem:', detalhe);
    throw err;
  }
}

// ─── Fila de reenvio ─────────────────────────────────────────────────────────

// Espera crescente entre tentativas: 1, 2, 5, 10, 30 min, 1 h, 2 h, 4 h, 8 h
const ESPERAS_REENVIO_SEG = [60, 120, 300, 600, 1800, 3600, 7200, 14400, 28800];
// Depois de 24 h tentando, o envio vai para "Envios perdidos" e espera ação manual
const JANELA_REENVIO_SEG = 24 * 3600;

async function postarTexto(phone: string, corpo: string): Promise<void> {
  await axios.post(`${API_URL()}/api/enviar-texto/${TOKEN()}`, { phone, message: corpo }, { timeout: 60000 });
}

function descreverErro(err: any): string {
  const status = err?.response?.status;
  const dados = err?.response?.data;
  const msg = typeof dados === 'string' ? dados : dados?.error || dados?.message || err?.message || 'erro desconhecido';
  return status ? `HTTP ${status}: ${String(msg).slice(0, 300)}` : String(msg).slice(0, 300);
}

// Sem resposta, tempo esgotado, 5xx, 408 e 429 são instabilidade; demais 4xx são definitivos
function erroTransitorio(err: any): boolean {
  const status = err?.response?.status;
  if (!status) return true;
  if (status >= 500) return true;
  return status === 408 || status === 429;
}

let processandoFila = false;

export async function processarFilaEnvios(): Promise<void> {
  if (processandoFila) return;
  // Pausa e calibragem seguram a fila: nada sai enquanto estiverem ligadas
  if (sistemaPausado() || modoCalibragem()) return;
  processandoFila = true;
  try {
    limparEnviosAntigos();
    const lote = enviosParaTentar(20);
    for (const envio of lote) {
      try {
        // Registra antes de postar: o eco do WhatsApp pode chegar antes da resposta
        // HTTP e, sem o registro, seria gravado como fala do Wesley
        registrarEnvioProprio(envio.phone, envio.corpo);
        await postarTexto(envio.phone, envio.corpo);
        atualizarEnvioFila(envio.id, { status: 'enviado', erro: null });
        console.log(`[fila] #${envio.id} reenviado para ${envio.phone} na tentativa ${envio.tentativas + 1}`);
      } catch (err: any) {
        const detalhe = descreverErro(err);
        const tentativas = envio.tentativas + 1;
        const agora = Math.floor(Date.now() / 1000);
        const esgotou = !erroTransitorio(err) || agora - envio.inicio_tentativas >= JANELA_REENVIO_SEG;
        if (esgotou) {
          atualizarEnvioFila(envio.id, { status: 'falhou', tentativas, erro: detalhe });
          console.error(`[fila] #${envio.id} para ${envio.phone} foi para Envios perdidos: ${detalhe}`);
        } else {
          const espera = ESPERAS_REENVIO_SEG[Math.min(tentativas - 1, ESPERAS_REENVIO_SEG.length - 1)];
          atualizarEnvioFila(envio.id, { status: 'pendente', tentativas, erro: detalhe, proximaTentativa: agora + espera });
          console.warn(`[fila] #${envio.id} falhou de novo (${detalhe}); próxima tentativa em ${Math.round(espera / 60)} min`);
        }
      }
      // Intervalo entre reenvios para não disparar em rajada após uma queda
      await new Promise(r => setTimeout(r, 3000));
    }
  } catch (err) {
    console.error('[fila] erro ao processar fila de envios:', err);
  } finally {
    processandoFila = false;
  }
}

// Reenvio manual pelo painel: tenta na hora, e se falhar de novo volta para a fila
export async function reenviarAgora(envio: { id: number; phone: string; corpo: string }): Promise<boolean> {
  if (sistemaPausado() || modoCalibragem()) return false;
  try {
    registrarEnvioProprio(envio.phone, envio.corpo);
    await postarTexto(envio.phone, envio.corpo);
    atualizarEnvioFila(envio.id, { status: 'enviado', erro: null });
    return true;
  } catch (err: any) {
    atualizarEnvioFila(envio.id, { status: 'falhou', erro: descreverErro(err) });
    return false;
  }
}

export async function sendAudio(phone: string, audioUrl: string): Promise<void> {
  if (sistemaPausado()) {
    console.log(`[send] BLOQUEADO (sistema pausado) — áudio NÃO enviado para ${phone}`);
    return;
  }
  if (interceptadoParaCalibragem(phone, `[áudio] ${audioUrl}`, 'áudio')) return;
  try {
    await axios.post(`${API_URL()}/api/enviar-audio/${TOKEN()}`, {
      phone,
      url: audioUrl,
    });
  } catch (err: any) {
    console.error('[send] erro ao enviar áudio:', err?.response?.data || err.message);
  }
}

export async function sendFile(phone: string, fileUrl: string, caption?: string): Promise<void> {
  if (sistemaPausado()) {
    console.log(`[send] BLOQUEADO (sistema pausado) — arquivo NÃO enviado para ${phone}`);
    return;
  }
  if (interceptadoParaCalibragem(phone, `[arquivo] ${fileUrl}${caption ? ' — ' + caption : ''}`, 'arquivo')) return;
  try {
    await axios.post(`${API_URL()}/api/enviar-arquivo/${TOKEN()}`, {
      phone,
      url: fileUrl,
      caption: caption || '',
    });
  } catch (err: any) {
    console.error('[send] erro ao enviar arquivo:', err?.response?.data || err.message);
    throw err;
  }
}

export async function createNote(phone: string, note: string): Promise<void> {
  if (sistemaPausado()) {
    console.log(`[send] BLOQUEADO (sistema pausado) — nota NÃO criada para ${phone}`);
    return;
  }
  try {
    await axios.post(`${API_URL()}/api/criar-nota/${TOKEN()}`, {
      phone,
      note,
    });
  } catch (err: any) {
    console.error('[send] erro ao criar nota:', err?.response?.data || err.message);
  }
}

// ─── Anotação no Trello só com envio confirmado ──────────────────────────────

// Deixa a anotação pendente até o eco da mensagem chegar pelo webhook (prova de
// que ela saiu pelo WhatsApp). O Waspeed não informa "entregue" nem "lido", então
// o eco é a confirmação mais forte disponível. Mensagem bloqueada, em calibragem
// ou duplicada nunca gera anotação.
export function anotarNoTrelloAoConfirmar(phone: string, resultado: ResultadoEnvio, cardId: string, nota: string, rotulo: string): void {
  if (resultado.status !== 'enviado' && resultado.status !== 'na_fila') {
    console.log(`[trello] não anotado (${resultado.status}) — card ${cardId}, ${phone}`);
    return;
  }
  registrarConfirmacaoPendente(chaveEco(phone, resultado.corpo), phone, cardId, nota, rotulo);
}

// Chamado pelo webhook a cada mensagem "fromMe": se for o eco de um envio com
// anotação pendente, grava no Trello com a hora da confirmação
export async function confirmarEnvioPorEco(phone: string, texto: string): Promise<void> {
  const pendentes = confirmacoesPendentesPorChave(chaveEco(phone, texto));
  if (!pendentes.length) return;
  const hora = new Date().toLocaleString('pt-BR', { timeZone: process.env.TZ_APP || 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  for (const p of pendentes) {
    try {
      await adicionarNotaCard(p.card_id, `${p.nota} — envio confirmado pelo WhatsApp em ${hora}`, { lancarErro: true });
      marcarConfirmacao(p.id, 'confirmado');
      console.log(`[trello] anotado após confirmação do envio — card ${p.card_id}, ${phone}`);
    } catch (err) {
      marcarConfirmacao(p.id, 'erro_trello');
      console.error(`[trello] envio confirmado, mas falhou ao anotar no card ${p.card_id}:`, err);
    }
  }
}

export function expirarConfirmacoesSemEco(): void {
  const n = expirarConfirmacoes();
  if (n) console.warn(`[trello] ${n} aviso(s) sem confirmação de envio em 24 h — nada foi anotado no Trello`);
}
