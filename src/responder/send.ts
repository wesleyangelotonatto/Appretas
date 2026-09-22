import axios from 'axios';
import { getSetting } from '../memory/db';

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

function chaveEco(phone: string, text: string): string {
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

export async function sendMessage(phone: string, text: string): Promise<void> {
  if (sistemaPausado()) {
    console.log(`[send] BLOQUEADO (sistema pausado) — mensagem NÃO enviada para ${phone}`);
    return;
  }
  registrarEnvioProprio(phone, text);
  try {
    await axios.post(`${API_URL()}/api/enviar-texto/${TOKEN()}`, {
      phone,
      message: text,
    });
  } catch (err: any) {
    console.error('[send] erro ao enviar mensagem:', err?.response?.data || err.message);
    throw err;
  }
}

export async function sendAudio(phone: string, audioUrl: string): Promise<void> {
  if (sistemaPausado()) {
    console.log(`[send] BLOQUEADO (sistema pausado) — áudio NÃO enviado para ${phone}`);
    return;
  }
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
