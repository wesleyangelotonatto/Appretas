import axios from 'axios';
import { dentroDaJanelaComercial } from '../flow/janela';

// Vigia de sistema: roda a cada 10 min, fora do caminho de atendimento.
// - Waspeed: a API responde e o token é aceito;
// - Webhook: chegam eventos do WhatsApp (silêncio longo em horário comercial indica
//   sessão desconectada no Waspeed);
// - CRM: o outro sistema está no ar (o CRM vigia a Iara do mesmo jeito — um avisa
//   quando o outro cai, já que um processo não consegue avisar a própria queda).
// Avisa no painel e no WhatsApp do Wesley na primeira falha confirmada (2 seguidas)
// e de novo quando volta. Sem repetir o aviso a cada 10 minutos.

const PHONE_WESLEY = () => process.env.PHONE_WESLEY || '5544999110862';
const HORAS_SILENCIO = () => parseFloat(process.env.MONITOR_HORAS_SILENCIO_WEBHOOK || '3');

let ultimoEventoWebhook = Date.now(); // ao subir, conta a partir do início
export function registrarEventoWebhook(): void { ultimoEventoWebhook = Date.now(); }

interface Estado { falhas: number; avisado: boolean; detalhe?: string }
const estados: Record<string, Estado> = {};

export interface StatusSistema { ok: boolean; verificacoes: Record<string, { ok: boolean; detalhe?: string }>; ultimoEventoWebhookMin: number }
let ultimoStatus: StatusSistema = { ok: true, verificacoes: {}, ultimoEventoWebhookMin: 0 };
export function statusAtual(): StatusSistema { return ultimoStatus; }

async function avisar(texto: string, viaWhatsApp: boolean) {
  console.warn(`[monitor] ${texto}`);
  import('../server').then(({ io }) => io?.emit('alerta', { tipo: 'sistema', mensagem: texto })).catch(() => {});
  if (!viaWhatsApp) return;
  try {
    const { sendMessage } = await import('../responder/send');
    await sendMessage(PHONE_WESLEY(), `⚠️ Aviso do sistema: ${texto}`, { assinar: false, rotulo: 'aviso de sistema' });
  } catch (err) { console.error('[monitor] não consegui avisar pelo WhatsApp:', err); }
}

async function registrar(nome: string, ok: boolean, detalhe: string, rotulo: string, whatsappDisponivel: boolean) {
  const e = estados[nome] || (estados[nome] = { falhas: 0, avisado: false });
  if (ok) {
    if (e.avisado) await avisar(`${rotulo} voltou a funcionar.`, whatsappDisponivel);
    e.falhas = 0; e.avisado = false; e.detalhe = undefined;
    return;
  }
  e.falhas++; e.detalhe = detalhe;
  if (e.falhas >= 2 && !e.avisado) {
    e.avisado = true;
    await avisar(`${rotulo} com problema: ${detalhe}`, whatsappDisponivel);
  }
}

async function verificarWaspeed(): Promise<{ ok: boolean; detalhe: string }> {
  const base = process.env.WASPEED_API_URL || 'https://api-whatsapp.wascript.com.br';
  const token = process.env.WASPEED_TOKEN || '';
  if (!token) return { ok: false, detalhe: 'WASPEED_TOKEN não configurado' };
  try {
    const r = await axios.get(`${base}/api/listar-etiquetas/${token}`, { timeout: 15000, validateStatus: () => true });
    if (r.status === 401 || r.status === 403) return { ok: false, detalhe: `token recusado (HTTP ${r.status})` };
    if (r.status >= 500) return { ok: false, detalhe: `Waspeed fora do ar (HTTP ${r.status})` };
    return { ok: true, detalhe: `HTTP ${r.status}` };
  } catch (err: any) {
    return { ok: false, detalhe: err?.code === 'ECONNABORTED' ? 'sem resposta em 15 s' : String(err?.message || err) };
  }
}

async function verificarCRM(): Promise<{ ok: boolean; detalhe: string } | null> {
  const url = process.env.CRM_URL;
  if (!url) return null; // CRM_URL não configurado: verificação desligada
  try {
    const r = await axios.get(`${url.replace(/\/$/, '')}/saude`, { timeout: 15000, validateStatus: () => true });
    return r.status < 400 ? { ok: true, detalhe: `HTTP ${r.status}` } : { ok: false, detalhe: `HTTP ${r.status}` };
  } catch (err: any) {
    return { ok: false, detalhe: String(err?.code || err?.message || err) };
  }
}

export async function executarMonitor(): Promise<StatusSistema> {
  const verificacoes: StatusSistema['verificacoes'] = {};

  const wa = await verificarWaspeed();
  verificacoes.waspeed = wa;
  await registrar('waspeed', wa.ok, wa.detalhe, 'A conexão com o Waspeed (WhatsApp)', false);

  const minutosSilencio = Math.round((Date.now() - ultimoEventoWebhook) / 60000);
  const silencioOk = !dentroDaJanelaComercial() || minutosSilencio < HORAS_SILENCIO() * 60;
  verificacoes.webhook = { ok: silencioOk, detalhe: `último evento há ${minutosSilencio} min` };
  await registrar('webhook', silencioOk, `nenhuma mensagem do WhatsApp chega há ${minutosSilencio} minutos — confira se o Waspeed está conectado`, 'O recebimento de mensagens do WhatsApp', wa.ok);

  // Google Drive: autorização válida e acesso à pasta raiz; se voltou, reenvia o que ficou guardado
  if (process.env.GOOGLE_OAUTH_CLIENT_ID) {
    const drive = await import('../integrations/drive');
    const t = await drive.testarDrive();
    const pend = drive.contarPendentes();
    verificacoes.drive = { ok: t.ok, detalhe: t.ok ? `ok${pend ? `, ${pend} documento(s) aguardando` : ''}` : t.erro };
    await registrar('drive', t.ok, `${t.erro} — os documentos ficam guardados e sobem quando voltar`, 'O Google Drive', wa.ok);
    if (t.ok && pend) drive.reenviarPendentes().then(r => r.enviados && console.log(`[monitor] ${r.enviados} documento(s) reenviado(s) ao Drive`)).catch(() => {});
  }

  const crm = await verificarCRM();
  if (crm) {
    verificacoes.crm = crm;
    await registrar('crm', crm.ok, crm.detalhe, 'O CRM', wa.ok);
  }

  ultimoStatus = { ok: Object.values(verificacoes).every(v => v.ok), verificacoes, ultimoEventoWebhookMin: minutosSilencio };
  return ultimoStatus;
}
