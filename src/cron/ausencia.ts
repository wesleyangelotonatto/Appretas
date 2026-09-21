import { getAusenciasPendentes, marcarAusenciaEnviada, saveMessage } from '../memory/db';
import { sendMessage } from '../responder/send';
import { MSG_FORA_HORARIO } from '../persona';
import { io } from '../server';

// Roda às 07h: entrega o aviso de ausência aos contatos que mandaram mensagem
// fora da janela 07h-22h e ainda não foram avisados
export async function cronAusenciaPendentes(): Promise<void> {
  const pendentes = getAusenciasPendentes();
  if (!pendentes.length) {
    console.log('[cron-ausencia] nenhum aviso pendente');
    return;
  }

  const hojeStr = new Date().toLocaleDateString('sv-SE', { timeZone: process.env.TZ_APP || 'America/Sao_Paulo' });
  let enviados = 0;

  for (const phone of pendentes) {
    try {
      await sendMessage(phone, MSG_FORA_HORARIO);
      saveMessage(phone, 'iara', MSG_FORA_HORARIO);
      io?.emit('message', { phone, role: 'iara', body: MSG_FORA_HORARIO, timestamp: Date.now() });
      marcarAusenciaEnviada(phone, hojeStr);
      enviados++;
    } catch (err) {
      console.error(`[cron-ausencia] erro ao enviar para ${phone}:`, err);
    }
  }

  console.log(`[cron-ausencia] ${enviados} aviso(s) pendente(s) entregue(s)`);
}
