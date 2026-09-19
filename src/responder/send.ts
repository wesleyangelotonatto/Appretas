import axios from 'axios';

const API_URL = () => process.env.WASPEED_API_URL || 'https://api-whatsapp.wascript.com.br';
const TOKEN = () => process.env.WASPEED_TOKEN || '';

export async function sendMessage(phone: string, text: string): Promise<void> {
  try {
    // Classic Wascript API: POST /api/enviar-texto/{TOKEN}
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
  try {
    await axios.post(`${API_URL()}/api/enviar-audio/${TOKEN()}`, {
      phone,
      url: audioUrl,
    });
  } catch (err: any) {
    console.error('[send] erro ao enviar áudio:', err?.response?.data || err.message);
  }
}

export async function createNote(phone: string, note: string): Promise<void> {
  try {
    // POST /api/criar-nota/{TOKEN} — cria nota no contato do Waspeed
    await axios.post(`${API_URL()}/api/criar-nota/${TOKEN()}`, {
      phone,
      note,
    });
  } catch (err: any) {
    console.error('[send] erro ao criar nota:', err?.response?.data || err.message);
  }
}
